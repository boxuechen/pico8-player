pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
frame=0

function seed_graphics()
 memset(0x4300,0,0x80)
 poke(0x4310,1,2,3,4,5,6,7,8)
 poke2(0x4320,0x1234)
 poke4(0x4324,0x11223344)
 memcpy(0x4330,0x4310,8)

 for y=0,7 do
  for x=0,7 do
   sset(8+x,y,(x+y)%7+1)
  end
 end
 fset(1,1,true)
 mset(0,0,1)
 mset(1,0,1)
end

function _init()
 seed_graphics()
end

function _update60()
 frame+=1
 poke(0x4300,frame)
 poke(0x4301,peek(0x4310)+frame)
end

function _draw()
 cls(0)
 pal()
 palt()
 camera(1,1)
 clip(0,0,128,128)
 pal(1,8)
 palt(0,false)

 fillp(0xa5a5)
 rectfill(2,2,18,10,0x21)
 fillp()
 line(2,12,18,18,9)
 circfill(24,8,5,10)
 oval(20,14,32,24,11)
 spr(1,4,28,1,1,false,false)
 map(0,0,40,8,2,1,1)
 tline(40,20,55,20,0,0,0.125,0,1)

 camera()
 clip()
 pal(1,14,1)
 pal(2,130,1)
 poke(0x4302,peek2(0x4320),peek4(0x4324))
 poke(0x4304,sget(8,0),mget(0,0),fget(1),fget(1,0) and 1 or 0)
 poke(0x4308,peek(0x4330),peek(0x4337))

 local v={1,2,3,4,5,6,7,8,9,10,11,12}
 for i=1,#v do pset(i-1,120,v[i]) end

 color(12)
 camera(3,-2)
 clip(4,5,100,90)
 pal(3,11)
 palt(5,true)
 fillp(0x5a5a)
end
